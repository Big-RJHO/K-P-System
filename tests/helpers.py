from cardgrader.models import CardAssessment, Centering, Defect, SideCentering


def card(front=(50, 50), back=(50, 50), defects=()) -> CardAssessment:
    return CardAssessment(
        centering=Centering(front=SideCentering(lr=front[0], tb=front[1]), back=SideCentering(lr=back[0], tb=back[1])),
        defects=[Defect(**d) for d in defects],
    )


def defect(type_, severity, side="front", location="surface"):
    return {"type": type_, "severity": severity, "side": side, "location": location}
